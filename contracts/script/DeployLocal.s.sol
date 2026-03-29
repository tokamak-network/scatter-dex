// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock identity registry that verifies everyone (for local testing)
contract MockIdentityRegistry is IIdentityRegistry {
    function isVerified(address) external pure override returns (bool) { return true; }
    function verifiedUntil(address) external pure override returns (uint64) { return type(uint64).max; }
    function paused() external pure override returns (bool) { return false; }
}

/// @dev Mock ERC20 token for local testing
contract MockToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Deploy everything for local E2E testing on anvil.
/// @dev Usage: forge script script/DeployLocal.s.sol --rpc-url http://localhost:8545 --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
contract DeployLocal is Script {
    function run() external {
        uint256 protocolFeeBps = 1000; // 10% of fee goes to treasury

        vm.startBroadcast();
        address deployer = msg.sender;

        // 1. Mock identity registry (everyone is verified)
        MockIdentityRegistry identityRegistry = new MockIdentityRegistry();
        console.log("MockIdentityRegistry:", address(identityRegistry));

        // 2. Identity gate
        IdentityGate gate = new IdentityGate(address(identityRegistry));
        console.log("IdentityGate:", address(gate));

        // 3. Relayer registry
        RelayerRegistry relayerRegistry = new RelayerRegistry(deployer); // deployer = treasury
        console.log("RelayerRegistry:", address(relayerRegistry));

        // 4. Settlement
        ScatterSettlement settlement = new ScatterSettlement(
            address(gate), address(relayerRegistry), protocolFeeBps
        );
        console.log("ScatterSettlement:", address(settlement));

        // 5. Mock tokens
        MockToken tokenA = new MockToken("Wrapped ETH", "WETH");
        MockToken tokenB = new MockToken("USD Coin", "USDC");
        console.log("WETH:", address(tokenA));
        console.log("USDC:", address(tokenB));

        // 6. Mint tokens to anvil default accounts
        address alice = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // anvil #0
        address bob = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;   // anvil #1

        tokenA.mint(alice, 1000 ether);
        tokenB.mint(alice, 1_000_000e18);
        tokenA.mint(bob, 1000 ether);
        tokenB.mint(bob, 1_000_000e18);
        console.log("Minted tokens to Alice and Bob");

        // 7. Register deployer as relayer
        relayerRegistry.register{value: 0.1 ether}("http://localhost:3001", 30);
        console.log("Deployer registered as relayer");

        vm.stopBroadcast();

        // Print summary
        console.log("");
        console.log("=== LOCAL DEPLOYMENT SUMMARY ===");
        console.log("NEXT_PUBLIC_SETTLEMENT_ADDRESS=", address(settlement));
        console.log("NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=", address(relayerRegistry));
        console.log("SETTLEMENT_ADDRESS=", address(settlement));
        console.log("WETH=", address(tokenA));
        console.log("USDC=", address(tokenB));
    }
}
