// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IdentityGate} from "../src/IdentityGate.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {ScatterSettlement} from "../src/ScatterSettlement.sol";
import {VaultSkills} from "../src/VaultSkills.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockToken} from "./DeployTestTokens.s.sol";
import {MockWETH} from "../test/mocks/MockWETH.sol";

/// @dev Mock identity registry that verifies everyone (for local testing)
contract MockIdentityRegistry is IIdentityRegistry {
    function isVerified(address) external pure override returns (bool) { return true; }
    function verifiedUntil(address) external pure override returns (uint64) { return type(uint64).max; }
    function paused() external pure override returns (bool) { return false; }
}

/// @notice Deploy everything for local E2E testing on anvil.
/// @dev Usage: forge script script/DeployLocal.s.sol --rpc-url http://localhost:8545 --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
contract DeployLocal is Script {
    function run() external {
        uint256 protocolFeeBps = 1000; // 10% of fee goes to treasury

        vm.startBroadcast();
        address deployer = msg.sender;

        // 1. Mock identity registries (Dual-CA: User CA + Relayer CA)
        MockIdentityRegistry userIdentityRegistry = new MockIdentityRegistry();
        console.log("MockIdentityRegistry (User CA):", address(userIdentityRegistry));

        MockIdentityRegistry relayerIdentityRegistry = new MockIdentityRegistry();
        console.log("MockIdentityRegistry (Relayer CA):", address(relayerIdentityRegistry));

        // 2. Identity gate (User CA)
        IdentityGate gate = new IdentityGate(address(userIdentityRegistry));
        console.log("IdentityGate:", address(gate));

        // 3. Relayer registry (Relayer CA)
        RelayerRegistry relayerRegistry = new RelayerRegistry(deployer, address(relayerIdentityRegistry));
        console.log("RelayerRegistry:", address(relayerRegistry));

        // 4. Mock tokens (WETH with deposit/withdraw, USDC as plain ERC20)
        MockWETH weth = new MockWETH();
        MockToken usdc = new MockToken("USD Coin", "USDC");
        console.log("WETH:", address(weth));
        console.log("USDC:", address(usdc));

        // 5. Settlement
        ScatterSettlement settlement = new ScatterSettlement(
            address(gate), address(relayerRegistry), address(weth), protocolFeeBps
        );
        console.log("ScatterSettlement:", address(settlement));

        // 6. VaultSkills (EIP-7702 delegation target)
        VaultSkills vaultSkills = new VaultSkills();
        console.log("VaultSkills:", address(vaultSkills));

        // 7. Whitelist tokens
        settlement.setTokenWhitelist(address(weth), true);
        settlement.setTokenWhitelist(address(usdc), true);
        console.log("Whitelisted WETH and USDC");

        // 8. Mint tokens to anvil default accounts
        address alice = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // anvil #0
        address bob = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;   // anvil #1

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(bob, 1_000_000e18);
        console.log("Minted USDC to Alice and Bob");

        // 9. Set min release delay to 1 second for local testing
        settlement.setMinReleaseDelay(1);
        console.log("Set minReleaseDelay to 1 second");

        // 10. Register deployer as relayer
        relayerRegistry.register{value: 0.1 ether}("http://localhost:3001", 30);
        console.log("Deployer registered as relayer");

        vm.stopBroadcast();

        // Print summary
        console.log("");
        console.log("=== LOCAL DEPLOYMENT SUMMARY ===");
        console.log(string.concat("NEXT_PUBLIC_SETTLEMENT_ADDRESS=", vm.toString(address(settlement))));
        console.log(string.concat("NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=", vm.toString(address(relayerRegistry))));
        console.log(string.concat("NEXT_PUBLIC_VAULTSKILLS_ADDRESS=", vm.toString(address(vaultSkills))));
        console.log(string.concat("NEXT_PUBLIC_WETH_ADDRESS=", vm.toString(address(weth))));
        console.log(string.concat("NEXT_PUBLIC_TOKENS=", vm.toString(address(weth)), ":WETH:18,", vm.toString(address(usdc)), ":USDC:18"));
        console.log(string.concat("NEXT_PUBLIC_RPC_URL=http://localhost:8545"));
        console.log(string.concat("NEXT_PUBLIC_CHAIN_ID=", vm.toString(block.chainid)));
    }
}
