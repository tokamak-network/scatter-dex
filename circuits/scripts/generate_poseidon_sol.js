// Generate Poseidon Solidity contracts from circomlibjs
const { buildPoseidon } = require("circomlibjs");
const fs = require("fs");
const path = require("path");

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Get round constants for t=3 (2 inputs) — used for Merkle tree
  const C_t3 = [];
  const M_t3 = [];
  // For t=5 (4 inputs) — used for commitment hash
  const C_t5 = [];
  const M_t5 = [];

  // We'll generate a simple wrapper that calls the precompiled Poseidon
  // For gas efficiency, we use assembly-optimized inline Poseidon

  const outputDir = path.join(__dirname, "../../contracts/src/zk");

  // Generate PoseidonT3 (2 inputs → 1 output, for Merkle tree)
  const t3Contract = `// SPDX-License-Identifier: MIT
// Auto-generated Poseidon hasher for t=3 (2 inputs)
// Used for Merkle tree internal nodes
pragma solidity ^0.8.28;

import {PoseidonUnit} from "./PoseidonUnit.sol";

library PoseidonT3 {
    function hash(uint256[2] memory inputs) internal pure returns (uint256) {
        uint256[] memory inp = new uint256[](2);
        inp[0] = inputs[0];
        inp[1] = inputs[1];
        return PoseidonUnit.poseidon(inp);
    }
}
`;

  // Generate PoseidonT5 (4 inputs → 1 output, for commitment)
  const t5Contract = `// SPDX-License-Identifier: MIT
// Auto-generated Poseidon hasher for t=5 (4 inputs)
// Used for commitment = Poseidon(secret, token, amount, salt)
pragma solidity ^0.8.28;

import {PoseidonUnit} from "./PoseidonUnit.sol";

library PoseidonT5 {
    function hash(uint256[4] memory inputs) internal pure returns (uint256) {
        uint256[] memory inp = new uint256[](4);
        inp[0] = inputs[0];
        inp[1] = inputs[1];
        inp[2] = inputs[2];
        inp[3] = inputs[3];
        return PoseidonUnit.poseidon(inp);
    }
}
`;

  // Generate the core PoseidonUnit with actual round constants
  // We use a simplified approach: hash via the EVM by embedding constants
  // For production, use the full circom Poseidon Solidity from poseidon-solidity package
  const poseidonUnitContract = `// SPDX-License-Identifier: MIT
// Poseidon hash function for EVM
// Reference: https://eips.ethereum.org/EIPS/eip-5988
pragma solidity ^0.8.28;

library PoseidonUnit {
    uint256 constant F = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function poseidon(uint256[] memory inputs) internal pure returns (uint256) {
        require(inputs.length > 0 && inputs.length <= 6, "invalid inputs");
        uint256 t = inputs.length + 1;
        uint256[] memory state = new uint256[](t);

        // Initialize state: state[0] = 0, state[i+1] = inputs[i]
        for (uint256 i = 0; i < inputs.length; i++) {
            state[i + 1] = inputs[i] % F;
        }

        // Full rounds + partial rounds (simplified reference implementation)
        // For production: use optimized assembly with precomputed round constants
        uint256 nRoundsF = 8;
        uint256 nRoundsP;
        if (t == 2) nRoundsP = 56;
        else if (t == 3) nRoundsP = 57;
        else if (t == 4) nRoundsP = 56;
        else if (t == 5) nRoundsP = 60;
        else if (t == 6) nRoundsP = 60;
        else if (t == 7) nRoundsP = 63;
        else revert("unsupported t");

        // NOTE: This is a placeholder. For a working implementation,
        // we need the actual round constants embedded.
        // In production, use the poseidon-solidity package or
        // deploy a precompiled Poseidon contract.

        // For now, we use an external call pattern where the Poseidon
        // contract is deployed separately with full constants.
        revert("Use deployed PoseidonHasher contract");
    }
}
`;

  fs.writeFileSync(path.join(outputDir, "PoseidonT3.sol"), t3Contract);
  fs.writeFileSync(path.join(outputDir, "PoseidonT5.sol"), t5Contract);

  console.log("Generated PoseidonT3.sol and PoseidonT5.sol");
  console.log("NOTE: For a working Poseidon, use poseidon-solidity package or deploy a hasher contract");
}

main().catch(console.error);
