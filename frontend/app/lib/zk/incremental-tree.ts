/**
 * Incremental Poseidon Merkle Tree — browser version.
 * Mirrors IncrementalMerkleTree.sol for O(depth) insertions.
 */

import { poseidonHash } from "./commitment";

// Precomputed zero hashes from IncrementalMerkleTree.sol._zeros()
const ZEROS: bigint[] = [
  0n,
  0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864n,
  0x1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1n,
  0x18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238n,
  0x07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952an,
  0x2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55n,
  0x2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78n,
  0x078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349dn,
  0x2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61n,
  0x0e884376d0d8fd21ecb780389e941f66e45e7acce3e228ab3e2156a614fcd747n,
  0x1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2n,
  0x1f8d8822725e36385200c0b201249819a6e6e1e4650808b5bebc6bface7d7636n,
  0x2c5d82f66c914bafb9701589ba8cfcfb6162b0a12acf88a8d0879a0471b5f85an,
  0x14c54148a0940bb820957f5adf3fa1134ef5c4aaa113f4646458f270e0bfbfd0n,
  0x190d33b12f986f961e10c0ee44d8b9af11be25588cad89d416118e4bf4ebe80cn,
  0x22f98aa9ce704152ac17354914ad73ed1167ae6596af510aa5b3649325e06c92n,
  0x2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323n,
  0x2e8186e558698ec1c67af9c14d463ffc470043c9c2988b954d75dd643f36b992n,
  0x0f57c5571e9a4eab49e2c8cf050dae948aef6ead647392273546249d1c1ff10fn,
  0x1830ee67b5fb554ad5f63d4388800e1cfe78e310697d46e43c9ce36134f72ccan,
  0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3en,
];

export class IncrementalMerkleTree {
  readonly depth: number;
  private filledSubtrees: bigint[];
  private _leaves: bigint[] = [];
  private _root: bigint;

  constructor(depth: number) {
    if (depth > ZEROS.length - 1) throw new Error(`depth ${depth} exceeds precomputed zeros`);
    this.depth = depth;
    this.filledSubtrees = ZEROS.slice(0, depth).map((z) => z);
    this._root = ZEROS[depth];
  }

  get root(): bigint { return this._root; }
  get nextIndex(): number { return this._leaves.length; }
  get leaves(): readonly bigint[] { return this._leaves; }

  async insert(leaf: bigint): Promise<number> {
    if (this._leaves.length >= 2 ** this.depth) throw new Error("tree full");
    let currentIndex = this._leaves.length;
    let currentHash = leaf;
    this._leaves.push(leaf);

    for (let i = 0; i < this.depth; i++) {
      const [left, right] = currentIndex % 2 === 0
        ? [currentHash, ZEROS[i]]
        : [this.filledSubtrees[i], currentHash];
      if (currentIndex % 2 === 0) this.filledSubtrees[i] = currentHash;
      currentHash = await poseidonHash([left, right]);
      currentIndex = Math.floor(currentIndex / 2);
    }

    this._root = currentHash;
    return this._leaves.length - 1;
  }

  static async fromLeaves(leaves: bigint[], depth: number): Promise<IncrementalMerkleTree> {
    const tree = new IncrementalMerkleTree(depth);
    for (const leaf of leaves) await tree.insert(leaf);
    return tree;
  }
}
